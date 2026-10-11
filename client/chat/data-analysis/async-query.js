(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state, esc, fmtNumber, activeDataset } = app;
    const byId = id => document.getElementById(id);
    const fetchJson = (...args) => app.fetchJson(...args);
    const toast = (...args) => app.toast(...args);
    const guardButton = (...args) => app.guardButton(...args);
    let pollTimer = null;

    function renderAsyncQueryJobs() {
        const box = byId('data-analysis-async-query-jobs');
        if (!box) return;
        const jobs = state.asyncQueryJobs || [];
        PivotSafeHtml.setHtml(box, jobs.length ? jobs.map(job => `<div class="data-analysis-asset-row"><div><strong>后台查询 · ${esc({ queued: '等待执行', running: '执行中', retry_wait: '等待重试', succeeded: '已完成', failed: '失败', cancelled: '已取消' }[job.status] || job.status)}</strong><span>进度 ${fmtNumber(job.progress)}% · 上限 ${fmtNumber(job.requestedLimit)} 行${job.lastError ? ` · ${esc(job.lastError)}` : ''}</span></div><div class="data-analysis-inline-actions">${job.status === 'succeeded' ? `<button class="btn-secondary" type="button" data-analysis-async-query-open="${esc(job.id)}">查看结果</button>` : ''}${['queued', 'running', 'retry_wait'].includes(job.status) ? `<button class="btn-secondary is-danger" type="button" data-analysis-async-query-cancel="${esc(job.id)}">取消</button>` : ''}</div></div>`).join('') : '');
    }

    async function loadAsyncQueryJobs({ silent = true } = {}) {
        const dataset = activeDataset();
        if (!dataset) { state.asyncQueryJobs = []; renderAsyncQueryJobs(); return; }
        try {
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/async-queries`);
            state.asyncQueryJobs = data.jobs || [];
            renderAsyncQueryJobs();
            const active = state.asyncQueryJobs.some(job => ['queued', 'running', 'retry_wait'].includes(job.status));
            if (active && !pollTimer) pollTimer = setInterval(() => loadAsyncQueryJobs({ silent: true }), 2500);
            else if (!active && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        } catch (error) {
            if (!silent) toast(error?.message || '加载后台查询任务失败', 'error');
        }
    }

    async function createAsyncQuery() {
        const dataset = activeDataset();
        const sql = String(byId('data-analysis-query-sql')?.value || '').trim();
        if (!dataset || !sql) throw new Error('请选择数据集并填写只读查询语句。');
        const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/async-queries`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, limit: 200000 })
        });
        state.asyncQueryJobs = [data.job, ...(state.asyncQueryJobs || [])].filter(Boolean);
        renderAsyncQueryJobs();
        await loadAsyncQueryJobs({ silent: true });
        toast('后台查询已创建，可在此查看进度、取消或打开结果。', 'success');
    }

    async function openAsyncQuery(jobId) {
        const data = await fetchJson(`${API}/async-queries/${encodeURIComponent(jobId)}`);
        const job = data.job;
        if (job.status !== 'succeeded') throw new Error('查询尚未完成。');
        state.query = { columns: job.columns || [], rows: job.previewRows || [], rowCount: (job.previewRows || []).length, truncated: Boolean(job.hasFile) };
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

    Object.assign(app, { loadAsyncQueryJobs, renderAsyncQueryJobs, bindAsyncQueryEvents });
})();
