/* DAG 执行链路甘特耗时瀑布图与性能度量模块 */

(function () {
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
    function computeTimelineData(nodes = [], runStates = new Map()) {
        const list = Array.isArray(nodes) ? nodes : [];
        const stateMap = runStates instanceof Map ? runStates : new Map(Object.entries(runStates || {}));

        let totalDurationMs = 0;
        let cachedCount = 0;
        let completedCount = 0;
        let errorCount = 0;
        let runningCount = 0;

        const items = list.map((node, index) => {
            const state = stateMap.get(node.id) || {};
            const durationMs = Number(state.durationMs) || (state.cached ? 1 : 0);
            const isCached = Boolean(state.cached || state.status === 'cached');
            const status = state.status || 'pending';

            if (isCached) cachedCount += 1;
            if (status === 'completed') completedCount += 1;
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
                order: index
            };
        });

        const maxDurationMs = Math.max(...items.map(it => it.durationMs), 1);

        // 计算相对占比与瀑布偏移
        let accumulatedMs = 0;
        const waterfallItems = items.map(item => {
            const widthPercent = Math.max(Math.min((item.durationMs / maxDurationMs) * 100, 100), 2);
            const offsetPercent = totalDurationMs > 0
                ? Math.min((accumulatedMs / totalDurationMs) * 100, 95)
                : 0;

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
    function showTimelineWaterfallModal({ nodes = [], runStates = new Map(), onFocusNode } = {}) {
        const safeHtml = window.Pivot?.safeHtml;
        if (!safeHtml || typeof document === 'undefined') return;

        const existing = document.querySelector('.pivot-dag-waterfall-modal');
        if (existing) existing.remove();

        const data = computeTimelineData(nodes, runStates);

        const modal = document.createElement('div');
        modal.className = 'pivot-dag-waterfall-modal-backdrop';

        const totalSeconds = (data.totalDurationMs / 1000).toFixed(2);

        const rowsHtml = data.items.map(item => {
            const statusBadge = item.isCached
                ? '<span class="waterfall-badge is-cached">快取</span>'
                : item.status === 'completed'
                    ? '<span class="waterfall-badge is-completed">已完成</span>'
                    : item.status === 'running'
                        ? '<span class="waterfall-badge is-running">运行中</span>'
                        : item.status === 'error'
                            ? '<span class="waterfall-badge is-error">失败</span>'
                            : '<span class="waterfall-badge is-pending">待调度</span>';

            const durationText = item.isCached
                ? '0ms'
                : item.durationMs >= 1000
                    ? `${(item.durationMs / 1000).toFixed(2)}s`
                    : `${item.durationMs}ms`;

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
                        <div class="pivot-waterfall-bar ${barColorClass}" data-bar-width="${item.widthPercent}"></div>
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
                <div class="pivot-dag-waterfall-list">
                    ${rowsHtml || '<div class="pivot-waterfall-empty">暂无节点执行数据，试跑工作流后即可查看完整耗时链路。</div>'}
                </div>
            </div>
        `;

        safeHtml.setHtml(modal, markup);
        document.body.appendChild(modal);

        modal.querySelectorAll('.pivot-waterfall-bar[data-bar-width]').forEach(bar => {
            const width = bar.getAttribute('data-bar-width');
            if (width) bar.style.width = `${width}%`;
        });

        modal.querySelector('.pivot-dag-waterfall-close')?.addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });

        modal.querySelectorAll('.pivot-waterfall-row').forEach(row => {
            row.addEventListener('click', () => {
                const id = row.getAttribute('data-node-id');
                if (id && typeof onFocusNode === 'function') {
                    onFocusNode(id);
                    modal.remove();
                }
            });
        });
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
