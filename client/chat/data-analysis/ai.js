
(function () {
    const app = window.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state, html, esc, fmtNumber, activeDataset } = app;
    const fetchJson = (...args) => app.fetchJson(...args);
    const guardButton = (...args) => app.guardButton(...args);
    const toast = (...args) => app.toast(...args);
    const setSelectOptions = (...args) => app.setSelectOptions(...args);
    const buildOptions = (...args) => app.buildOptions(...args);

    const semanticStatusLabels = {
        queued: '排队中',
        running: '分析中',
        succeeded: '已完成',
        failed: '失败',
        cancelled: '已取消'
    };

    function clearSemanticPoll() {
        if (state.semanticPollTimer) {
            clearInterval(state.semanticPollTimer);
            state.semanticPollTimer = null;
        }
    }

    function isActiveSemanticJob(job) {
        return Boolean(job && ['queued', 'running'].includes(job.status));
    }

    function setAiRunning(running) {
        state.aiBusy = Boolean(running);
        const stopBtn = document.getElementById('data-analysis-ai-stop');
        const runBtn = document.getElementById('data-analysis-ai-run');
        const promptInput = document.getElementById('data-analysis-ai-prompt');
        const deepToggle = document.getElementById('data-analysis-ai-deep');
        if (stopBtn) stopBtn.classList.toggle('hidden', !running);
        if (runBtn) {
            runBtn.disabled = Boolean(running);
            runBtn.textContent = running ? '分析中…' : '生成建议';
        }
        if (promptInput) promptInput.disabled = Boolean(running);
        if (deepToggle) deepToggle.disabled = Boolean(running);
    }

    function stopAi() {
        if (state.aiAbortController) {
            state.aiAbortController.abort();
            state.aiAbortController = null;
        }
        state.aiWorkspaceEpoch = Number(state.aiWorkspaceEpoch || 0) + 1;
        setAiRunning(false);
        const result = document.getElementById('data-analysis-ai-result');
        if (result && result.querySelector('.data-analysis-ai-thinking')) {
            PivotSafeHtml.setHtml(result, '<div class="data-analysis-empty">已停止生成建议。</div>');
        }
        toast('已停止生成建议', 'info');
    }

    // 智能分析结果只属于当前页面会话。离开页面时清理临时展示内容；
    // 已结束的全量任务回到历史记录中，只有仍在运行的任务保留进度入口。
    function resetAiWorkspace() {
        clearSemanticPoll();
        if (state.aiAbortController) {
            state.aiAbortController.abort();
            state.aiAbortController = null;
        }
        state.aiWorkspaceEpoch = Number(state.aiWorkspaceEpoch || 0) + 1;
        setAiRunning(false);
        const result = document.getElementById('data-analysis-ai-result');
        if (result) PivotSafeHtml.setHtml(result, '');
        const prompt = document.getElementById('data-analysis-ai-prompt');
        if (prompt) prompt.value = '';
        const deep = document.getElementById('data-analysis-ai-deep');
        if (deep) deep.checked = false;
        const instruction = document.getElementById('data-analysis-semantic-instruction');
        if (instruction && !isActiveSemanticJob(state.semanticJob)) instruction.value = '';
        if (!isActiveSemanticJob(state.semanticJob)) {
            state.semanticJob = null;
            renderSemanticControls();
        }
    }

    function resumeAiWorkspace() {
        renderSemanticControls();
        if (isActiveSemanticJob(state.semanticJob)) startSemanticPoll(state.semanticJob.id);
    }

    function renderSemanticControls() {
        const dataset = activeDataset();
        const columns = dataset?.columns || [];
        if (!document.getElementById('data-analysis-semantic-field')) return;
        const profile = Array.isArray(dataset?.profile) ? dataset.profile : [];
        const textColumns = columns.filter(column => profile.find(item => item.key === column.key && item.type === 'text'));
        const textOptions = buildOptions(textColumns.length ? textColumns : columns, { includeEmpty: true, emptyLabel: '请选择文本字段' });
        setSelectOptions('data-analysis-semantic-field', textOptions, document.getElementById('data-analysis-semantic-field')?.value || textColumns[0]?.key || columns[0]?.key || '');
        setSelectOptions('data-analysis-semantic-id-field', buildOptions(columns, { includeEmpty: true, emptyLabel: '按行号标识' }));

        const job = state.semanticJob;
        const status = document.getElementById('data-analysis-semantic-status');
        const progress = document.getElementById('data-analysis-semantic-progress');
        const report = document.getElementById('data-analysis-semantic-report');
        const run = document.getElementById('data-analysis-semantic-run');
        const cancel = document.getElementById('data-analysis-semantic-cancel');
        const retry = document.getElementById('data-analysis-semantic-retry');
        if (!job) {
            if (status) status.textContent = '未创建任务';
            if (progress) PivotSafeHtml.setHtml(progress, '');
            if (report) PivotSafeHtml.setHtml(report, '');
            cancel?.classList.add('hidden');
            retry?.classList.add('hidden');
            if (run) run.disabled = false;
            return;
        }
        if (status) {
            status.textContent = semanticStatusLabels[job.status] || job.status;
            status.dataset.status = job.status;
        }
        const completed = Number(job.completedBatches || 0);
        const total = Number(job.totalBatches || 0);
        const percent = Math.max(0, Math.min(100, Number(job.progress || 0)));
        if (progress) {
            PivotSafeHtml.setHtml(progress, `
                <div class="data-analysis-semantic-progress-meta"><span>${esc(job.status === 'succeeded' ? '全部记录已完成' : `已完成 ${completed}/${total || '?'} 批`)}</span><span>${percent}%</span></div>
                <div class="data-analysis-semantic-progress-track"><span style="width:${percent}%"></span></div>
                <div class="data-analysis-semantic-progress-detail">覆盖 ${fmtNumber(job.analyzedRows || job.totalRows)} 行，${fmtNumber(job.totalChars)} 字符${job.lastError ? `；${esc(job.lastError)}` : ''}</div>
            `);
        }
        if (report) {
            const text = String(job.report || job.result?.report || '');
            PivotSafeHtml.setHtml(report, text ? `<div class="data-analysis-semantic-report-title">全量汇总报告</div>${renderMarkdown(text)}` : '');
        }
        const active = ['queued', 'running'].includes(job.status);
        run && (run.disabled = active);
        cancel?.classList.toggle('hidden', !active);
        retry?.classList.toggle('hidden', job.status !== 'failed' && job.status !== 'cancelled');
    }

    async function loadSemanticJobs(datasetId = activeDataset()?.id) {
        clearSemanticPoll();
        state.semanticJobs = [];
        state.semanticJob = null;
        if (!datasetId) {
            renderSemanticControls();
            return;
        }
        try {
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(datasetId)}/semantic-analysis/jobs?limit=20`);
            state.semanticJobs = Array.isArray(data.jobs) ? data.jobs : [];
            state.semanticJob = state.semanticJobs.find(isActiveSemanticJob) || null;
            renderSemanticControls();
            if (state.semanticJob && ['queued', 'running'].includes(state.semanticJob.status)) startSemanticPoll(state.semanticJob.id);
        } catch (e) {
            console.warn('[data-analysis] 加载全量语义分析任务失败', e);
            renderSemanticControls();
        }
    }

    async function refreshSemanticJob(jobId) {
        const data = await fetchJson(`${API}/semantic-analysis/jobs/${encodeURIComponent(jobId)}`);
        if (state.semanticJob?.id !== jobId) return;
        state.semanticJob = data.job || state.semanticJob;
        const index = state.semanticJobs.findIndex(item => item.id === jobId);
        if (index >= 0) state.semanticJobs[index] = { ...state.semanticJobs[index], ...state.semanticJob, batches: undefined };
        renderSemanticControls();
        if (!['queued', 'running'].includes(state.semanticJob.status)) clearSemanticPoll();
    }

    function startSemanticPoll(jobId) {
        clearSemanticPoll();
        let busy = false;
        state.semanticPollTimer = setInterval(async () => {
            if (busy) return;
            busy = true;
            try { await refreshSemanticJob(jobId); } catch (e) { console.warn('[data-analysis] 轮询全量语义分析任务失败', e); } finally { busy = false; }
        }, 2500);
    }

    async function runSemanticAnalysis() {
        const dataset = activeDataset();
        if (!dataset) return toast('请选择分析数据集', 'warning');
        const textField = document.getElementById('data-analysis-semantic-field')?.value;
        const instruction = document.getElementById('data-analysis-semantic-instruction')?.value.trim();
        if (!textField) return toast('请选择文本字段', 'warning');
        if (!instruction) return toast('请填写全量语义分析要求', 'warning');
        await guardButton('data-analysis-semantic-run', '创建中…', async () => {
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/semantic-analysis`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    textField,
                    idField: document.getElementById('data-analysis-semantic-id-field')?.value || '',
                    instruction,
                    batchTokens: document.getElementById('data-analysis-semantic-batch-tokens')?.value || 24000,
                    model: document.getElementById('model-selector')?.value || ''
                })
            });
            state.semanticJob = data.job;
            state.semanticJobs = [data.job, ...state.semanticJobs.filter(item => item.id !== data.job.id)];
            renderSemanticControls();
            startSemanticPoll(data.job.id);
            toast('全量语义分析任务已启动');
        });
    }

    async function cancelSemanticAnalysis() {
        const job = state.semanticJob;
        if (!job) return;
        await guardButton('data-analysis-semantic-cancel', '取消中…', async () => {
            const data = await fetchJson(`${API}/semantic-analysis/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST' });
            state.semanticJob = data.job;
            clearSemanticPoll();
            renderSemanticControls();
            toast('全量语义分析任务已取消');
        });
    }

    async function retrySemanticAnalysis() {
        const job = state.semanticJob;
        if (!job) return;
        await guardButton('data-analysis-semantic-retry', '重试中…', async () => {
            const data = await fetchJson(`${API}/semantic-analysis/jobs/${encodeURIComponent(job.id)}/retry`, { method: 'POST' });
            state.semanticJob = data.job;
            renderSemanticControls();
            startSemanticPoll(job.id);
            toast('失败批次已重新排队');
        });
    }

    // 打字机回放：把已完成的文本分块增量渲染，模拟流式逐字输出（仅前端，不改后端）。
    // 帧数固定（约 120 帧），与文本长度无关，保证长短答案的回放时长都可控（约 2 秒）。
    function typewriterReplay(el, fullText, render, shouldContinue = () => true) {
        return new Promise(resolve => {
            const text = String(fullText || '');
            if (!el || !shouldContinue()) { resolve(); return; }
            // 用户偏好减少动效时直接整段渲染，不做打字机。
            const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (reduceMotion || text.length <= 12) {
                PivotSafeHtml.setHtml(el, render(text));
                resolve();
                return;
            }
            const chunkSize = Math.max(3, Math.ceil(text.length / 120));
            let i = 0;
            const step = () => {
                if (!shouldContinue()) { resolve(); return; }
                i = Math.min(text.length, i + chunkSize);
                PivotSafeHtml.setHtml(el, render(text.slice(0, i)));
                if (i >= text.length) { resolve(); return; }
                setTimeout(step, 18);
            };
            step();
        });
    }

    // 深度分析回放：先用打字机逐字回放最终答案，回放结束后再补齐执行过程与内联图表。
    async function replayAgentResult(box, data, shouldContinue = () => true) {
        if (!box) return;
        const answer = String(data && data.answer ? data.answer : 'AI 未返回有效内容');
        PivotSafeHtml.setHtml(box, '<div class="data-analysis-ai-answer"></div>');
        const answerEl = box.querySelector('.data-analysis-ai-answer');
        await typewriterReplay(answerEl, answer, text => renderMarkdown(text), shouldContinue);
        if (!shouldContinue()) return;
        // 最终完整渲染：答案 + 图表 + 执行过程，并初始化图表（图表需在 DOM 落定后挂载）。
        renderAgentResult(box, data);
    }

    // 深度分析：调用后端 ReAct 工具调用接口，渲染答案 + 执行过程 + 内联图表。
    async function runAiAgent(dataset, prompt, model, result) {
        const workspaceEpoch = Number(state.aiWorkspaceEpoch || 0);
        const controller = new AbortController();
        state.aiAbortController = controller;
        setAiRunning(true);
        if (result) PivotSafeHtml.setHtml(result, '<div class="data-analysis-ai-thinking">AI 正在查询数据并深度分析…</div>');
        try {
            const data = await fetchJson(`${API}/ai`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'agent', datasetId: dataset.id, prompt, model }),
                signal: controller.signal
            });
            if (controller.signal.aborted || workspaceEpoch !== Number(state.aiWorkspaceEpoch || 0)) return;
            await replayAgentResult(result, data, () => !controller.signal.aborted && workspaceEpoch === Number(state.aiWorkspaceEpoch || 0));
        } catch (e) {
            if (controller.signal.aborted || e.name === 'AbortError' || workspaceEpoch !== Number(state.aiWorkspaceEpoch || 0)) {
                if (result && result.querySelector('.data-analysis-ai-thinking')) {
                    PivotSafeHtml.setHtml(result, '<div class="data-analysis-empty">已停止生成建议。</div>');
                }
                return;
            }
            if (result) PivotSafeHtml.setHtml(result, `<div class="data-analysis-empty">深度分析失败：${esc(e && e.message ? e.message : '请稍后重试')}</div>`);
            toast(e && e.message ? e.message : '深度分析失败', 'error');
        } finally {
            if (state.aiAbortController === controller) {
                state.aiAbortController = null;
                setAiRunning(false);
            }
        }
    }

    function renderAgentResult(box, data) {
        if (!box) return;
        const steps = data.steps || [];
        const charts = data.charts || [];
        const toolLabel = { run_sql: 'SQL 查询', make_chart: '生成图表' };
        const stepsHtml = steps.length ? `
            <details class="data-analysis-ai-steps">
                <summary>执行过程（${steps.length} 步）</summary>
                ${steps.map(step => {
                    const failed = step.status === 'error' || /^失败/.test(String(step.summary || ''));
                    const stepClass = `data-analysis-ai-step${failed ? ' is-error' : ''}`;
                    const summary = step.error || step.summary || '';
                    return `
                        <div class="${stepClass}">
                            <span class="data-analysis-ai-step-tool">${esc(toolLabel[step.tool] || step.tool)}</span>
                            <code>${esc(step.input?.sql || JSON.stringify(step.input || {}))}</code>
                            <em>${esc(summary)}</em>
                        </div>
                    `;
                }).join('')}
            </details>
        ` : '';
        const evidence = Array.isArray(data.evidence) ? data.evidence : [];
        const scopeNotice = data.scope === 'profile'
            ? '<div class="data-analysis-ai-scope-notice">本回答基于数据集字段画像与统计摘要，未执行逐行查询，不应视为精确全量结论。</div>'
            : '';
        const evidenceHtml = evidence.length ? `
            <details class="data-analysis-ai-evidence">
                <summary>数据依据（${evidence.length} 次查询）</summary>
                ${evidence.map(item => `<div class="data-analysis-ai-evidence-item"><code>${esc(item.sql || '')}</code><span>返回 ${esc(item.rowCount)} 行${item.truncated ? '，结果已截断' : ''}</span></div>`).join('')}
            </details>
        ` : (data.scope === 'profile' ? '' : '<div class="data-analysis-ai-no-evidence">本次回答未获得可验证的 SQL 查询依据。</div>');
        const chartsHtml = charts.length ? `<div class="data-analysis-ai-charts">${charts.map(chart => `
            <div class="pivot-echart-block" data-pivot-echart="${html.escapeAttr(JSON.stringify(chart))}">
                <div class="pivot-echart-title">${esc(chart.title || '图表')}</div>
                <div class="pivot-echart-canvas"></div>
                <canvas height="300"></canvas>
                <pre class="pivot-echart-error-text"></pre>
            </div>
        `).join('')}</div>` : '';
        PivotSafeHtml.setHtml(box, `
            ${scopeNotice}
            <div class="data-analysis-ai-answer">${renderMarkdown(data.answer || 'AI 未返回有效内容')}</div>
            ${chartsHtml}
            ${evidenceHtml}
            ${stepsHtml}
        `);
        if (charts.length) window.renderPivotCharts?.(box);
    }

    async function runAi() {
        const dataset = activeDataset();
        if (!dataset) {
            toast('请选择分析数据集', 'warning');
            return;
        }
        const prompt = document.getElementById('data-analysis-ai-prompt')?.value.trim();
        if (!prompt) {
            toast('请输入分析问题', 'warning');
            return;
        }
        if (state.aiBusy) return;
        const result = document.getElementById('data-analysis-ai-result');
        const workspaceEpoch = Number(state.aiWorkspaceEpoch || 0);
        const model = document.getElementById('model-selector')?.value || '';
        const deep = document.getElementById('data-analysis-ai-deep')?.checked;
        if (deep) {
            await runAiAgent(dataset, prompt, model, result);
            return;
        }
        // 环境支持时走 SSE 流式逐字输出，否则回退一次性请求。
        const useStream = typeof createBrowserSseParser === 'function' && typeof apiFetch === 'function';
        const controller = new AbortController();
        state.aiAbortController = controller;
        setAiRunning(true);
        if (result) PivotSafeHtml.setHtml(result, '<div class="data-analysis-ai-thinking">AI 正在分析...</div>');
        try {
            if (!useStream) {
                const data = await fetchJson(`${API}/ai`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ datasetId: dataset.id, prompt, model }),
                    signal: controller.signal
                });
                if (controller.signal.aborted || workspaceEpoch !== Number(state.aiWorkspaceEpoch || 0)) return;
                if (result) PivotSafeHtml.setHtml(result, `${data.analysisScope === 'profile' ? '<div class="data-analysis-ai-scope-notice">本回答基于字段画像与统计摘要，未执行逐行查询。</div>' : ''}${renderMarkdown(data.content || 'AI 未返回有效内容')}`);
                return;
            }
            const res = await apiFetch(`${API}/ai`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                body: JSON.stringify({ datasetId: dataset.id, prompt, model, stream: true }),
                signal: controller.signal
            });
            if (!res.ok || !res.body) {
                const data = await res.clone().json().catch(() => ({}));
                throw new Error(data?.error?.message || `AI 请求失败（${res.status}）`);
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let full = '';
            const parser = createBrowserSseParser({
                onData(p) {
                    if (controller.signal.aborted || workspaceEpoch !== Number(state.aiWorkspaceEpoch || 0)) return;
                    let data = null;
                    try { data = JSON.parse(p); } catch (_e) { return; }
                    const chunk = data?.content ?? data?.choices?.[0]?.delta?.content ?? '';
                    if (chunk) {
                        full += chunk;
                        if (result) PivotSafeHtml.setHtml(result, renderMarkdown(full));
                    }
                }
            });
            while (!parser.isDone()) {
                if (controller.signal.aborted) break;
                const { done, value } = await reader.read();
                if (done || controller.signal.aborted) {
                    parser.write(decoder.decode());
                    parser.end();
                    break;
                }
                parser.write(decoder.decode(value, { stream: true }));
            }
            if (controller.signal.aborted || workspaceEpoch !== Number(state.aiWorkspaceEpoch || 0)) return;
            if (result) PivotSafeHtml.setHtml(result, renderMarkdown(full.trim() || 'AI 未返回有效内容'));
        } catch (e) {
            if (controller.signal.aborted || e.name === 'AbortError' || workspaceEpoch !== Number(state.aiWorkspaceEpoch || 0)) {
                if (result && result.querySelector('.data-analysis-ai-thinking')) {
                    PivotSafeHtml.setHtml(result, '<div class="data-analysis-empty">已停止生成建议。</div>');
                }
                return;
            }
            if (result) PivotSafeHtml.setHtml(result, `<div class="data-analysis-empty">AI 分析失败：${esc(e && e.message ? e.message : '请稍后重试')}</div>`);
            toast(e && e.message ? e.message : 'AI 分析失败', 'error');
        } finally {
            if (state.aiAbortController === controller) {
                state.aiAbortController = null;
                setAiRunning(false);
            }
        }
    }

    Object.assign(app, {
        runAiAgent,
        renderAgentResult,
        replayAgentResult,
        runAi,
        stopAi,
        resetAiWorkspace,
        resumeAiWorkspace,
        renderSemanticControls,
        loadSemanticJobs,
        runSemanticAnalysis,
        cancelSemanticAnalysis,
        retrySemanticAnalysis
    });
})();
