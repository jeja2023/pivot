(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state, esc, fmtNumber, activeDataset } = app;
    const byId = id => document.getElementById(id);
    const fetchJson = (...args) => app.fetchJson(...args);
    const toast = (...args) => app.toast(...args);
    const guardButton = (...args) => app.guardButton(...args);
    let pollTimer = null;
    let loadSequence = 0;

    function visible() {
        const view = byId('data-analysis-view');
        const panel = byId('data-analysis-query-panel');
        return !document.hidden && view && !view.closest('.hidden, [hidden], [aria-hidden="true"]') && panel && !panel.classList.contains('hidden');
    }

    function stopAsyncQueryPolling() {
        loadSequence += 1;
        clearTimeout(pollTimer); pollTimer = null;
    }

    function renderAsyncQueryJobs() {
        const box = byId('data-analysis-async-query-jobs');
        if (!box) return;
        const jobs = state.asyncQueryJobs || [];
        PivotSafeHtml.setHtml(box, jobs.length ? jobs.map(job => `<div class="data-analysis-asset-row"><div><strong>后台查询 · ${esc({ queued: '等待执行', running: '执行中', retry_wait: '等待重试', succeeded: '已完成', failed: '失败', cancelled: '已取消' }[job.status] || job.status)}</strong><span>进度 ${fmtNumber(job.progress)}% · 上限 ${fmtNumber(job.requestedLimit)} 行${job.lastError ? ` · ${esc(job.lastError)}` : ''}</span></div><div class="data-analysis-inline-actions">${job.status === 'succeeded' ? `<button class="btn-secondary" type="button" data-analysis-async-query-open="${esc(job.id)}">查看结果</button>` : ''}${['queued', 'running', 'retry_wait'].includes(job.status) ? `<button class="btn-secondary is-danger" type="button" data-analysis-async-query-cancel="${esc(job.id)}">取消</button>` : ''}</div></div>`).join('') : '');
    }

    async function loadAsyncQueryJobs({ silent = true } = {}) {
        stopAsyncQueryPolling();
        const sequence = loadSequence;
        const dataset = activeDataset();
        if (!dataset) { state.asyncQueryJobs = []; renderAsyncQueryJobs(); return; }
        try {
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/async-queries`);
            if (sequence !== loadSequence || activeDataset()?.id !== dataset.id) return;
            state.asyncQueryJobs = data.jobs || [];
            renderAsyncQueryJobs();
            const active = state.asyncQueryJobs.some(job => ['queued', 'running', 'retry_wait'].includes(job.status));
            if (active && visible()) pollTimer = setTimeout(() => {
                pollTimer = null;
                if (visible()) void loadAsyncQueryJobs({ silent: true });
            }, 2500);
        } catch (error) {
            if (sequence !== loadSequence || activeDataset()?.id !== dataset.id) return;
            if (!silent) toast(error?.message || '加载后台查询任务失败', 'error');
            if (visible()) pollTimer = setTimeout(() => { if (visible()) void loadAsyncQueryJobs({ silent: true }); }, 5000);
        }
    }

    async function createAsyncQuery() {
        const dataset = activeDataset();
        const sql = String(byId('data-analysis-query-sql')?.value || '').trim();
        if (!dataset || !sql) throw new Error('请选择数据集并填写只读查询语句。');
        const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/async-queries`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, limit: 200000 })
        });
        if (activeDataset()?.id !== dataset.id) { toast(`数据集“${dataset.name}”的后台查询已创建，可切回查看进度。`, 'success'); return; }
        state.asyncQueryJobs = [data.job, ...(state.asyncQueryJobs || [])].filter(Boolean);
        renderAsyncQueryJobs();
        await loadAsyncQueryJobs({ silent: true });
        toast('后台查询已创建，可在此查看进度、取消或打开结果。', 'success');
    }

    async function openAsyncQuery(jobId) {
        const current = app.captureRequest('query');
        const data = await fetchJson(`${API}/async-queries/${encodeURIComponent(jobId)}`);
        if (!current()) return;
        const job = data.job;
        if (job.status !== 'succeeded') throw new Error('查询尚未完成。');
        if (job.resultUnavailable) throw new Error(job.resultUnavailableReason || '来源数据或权限已变化，请重新运行查询。');
        if (job.datasetId !== state.activeId) return;
        state.query = { columns: job.columns || [], rows: job.previewRows || [], rowCount: (job.previewRows || []).length, totalRowCount: job.rowCount, truncated: Boolean(job.truncated) || Number(job.rowCount) > (job.previewRows || []).length };
        state.queryPage = 1;
        app.renderQuery?.();
        toast('已载入后台查询结果预览；完整结果作为受控产物保留。', 'success');
    }

    async function cancelAsyncQuery(jobId) {
        await fetchJson(`${API}/async-queries/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
        await loadAsyncQueryJobs({ silent: true });
        toast('后台查询已取消。', 'success');
    }

    function bindAsyncQueryEvents(root) {
        if (!root || root.dataset.asyncQueryEventsBound === 'true') return;
        root.dataset.asyncQueryEventsBound = 'true';
        root.addEventListener('click', async event => {
            try {
                if (event.target.closest('#data-analysis-run-query-async')) { await guardButton('data-analysis-run-query-async', '已提交…', createAsyncQuery); return; }
                const open = event.target.closest('[data-analysis-async-query-open]');
                if (open) { await openAsyncQuery(open.dataset.analysisAsyncQueryOpen); return; }
                const cancel = event.target.closest('[data-analysis-async-query-cancel]');
                if (cancel) { await cancelAsyncQuery(cancel.dataset.analysisAsyncQueryCancel); return; }
            } catch (error) {
                toast(error?.message || '后台查询操作失败', 'error');
            }
        });
    }

    document.addEventListener('visibilitychange', () => { if (visible()) void loadAsyncQueryJobs({ silent: true }); else stopAsyncQueryPolling(); });
    window.addEventListener('pagehide', stopAsyncQueryPolling);
    Object.assign(app, { loadAsyncQueryJobs, renderAsyncQueryJobs, bindAsyncQueryEvents, stopAsyncQueryPolling });
})();
