
(function () {
    const app = window.PivotDataAnalysis;
    if (!app) throw new Error('PivotDataAnalysis context is not loaded');
    const { API, state, html, esc, activeDataset } = app;
    const fetchJson = (...args) => app.fetchJson(...args);
    const guardButton = (...args) => app.guardButton(...args);
    const toast = (...args) => app.toast(...args);

    // 打字机回放：把已完成的文本分块增量渲染，模拟流式逐字输出（仅前端，不改后端）。
    // 帧数固定（约 120 帧），与文本长度无关，保证长短答案的回放时长都可控（约 2 秒）。
    function typewriterReplay(el, fullText, render) {
        return new Promise(resolve => {
            const text = String(fullText || '');
            if (!el) { resolve(); return; }
            // 用户偏好减少动效时直接整段渲染，不做打字机。
            const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (reduceMotion || text.length <= 12) {
                el.innerHTML = render(text);
                resolve();
                return;
            }
            const chunkSize = Math.max(3, Math.ceil(text.length / 120));
            let i = 0;
            const step = () => {
                i = Math.min(text.length, i + chunkSize);
                el.innerHTML = render(text.slice(0, i));
                if (i >= text.length) { resolve(); return; }
                setTimeout(step, 18);
            };
            step();
        });
    }

    // 深度分析回放：先用打字机逐字回放最终答案，回放结束后再补齐执行过程与内联图表。
    async function replayAgentResult(box, data) {
        if (!box) return;
        const answer = String(data && data.answer ? data.answer : 'AI 未返回有效内容');
        box.innerHTML = '<div class="data-analysis-ai-answer"></div>';
        const answerEl = box.querySelector('.data-analysis-ai-answer');
        await typewriterReplay(answerEl, answer, text => renderMarkdown(text));
        // 最终完整渲染：答案 + 图表 + 执行过程，并初始化图表（图表需在 DOM 落定后挂载）。
        renderAgentResult(box, data);
    }

    // 深度分析：调用后端 ReAct 工具调用接口，渲染答案 + 执行过程 + 内联图表。
    async function runAiAgent(dataset, prompt, model, result) {
        state.aiBusy = true;
        if (result) result.innerHTML = '<div class="data-analysis-ai-thinking">AI 正在查询数据并分析…</div>';
        await guardButton('data-analysis-ai-run', '分析中…', async () => {
            try {
                const data = await fetchJson(`${API}/ai`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: 'agent', datasetId: dataset.id, prompt, model })
                });
                await replayAgentResult(result, data);
            } catch (e) {
                if (result) result.innerHTML = `<div class="data-analysis-empty">深度分析失败：${esc(e && e.message ? e.message : '请稍后重试')}</div>`;
                toast(e && e.message ? e.message : '深度分析失败', 'error');
            } finally {
                state.aiBusy = false;
            }
        });
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
        const chartsHtml = charts.length ? `<div class="data-analysis-ai-charts">${charts.map(chart => `
            <div class="pivot-echart-block" data-pivot-echart="${html.escapeAttr(JSON.stringify(chart))}">
                <div class="pivot-echart-title">${esc(chart.title || '图表')}</div>
                <div class="pivot-echart-canvas"></div>
                <canvas height="300"></canvas>
                <pre class="pivot-echart-error-text"></pre>
            </div>
        `).join('')}</div>` : '';
        box.innerHTML = `
            <div class="data-analysis-ai-answer">${renderMarkdown(data.answer || 'AI 未返回有效内容')}</div>
            ${chartsHtml}
            ${stepsHtml}
        `;
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
        const model = document.getElementById('model-selector')?.value || '';
        const deep = document.getElementById('data-analysis-ai-deep')?.checked;
        if (deep) {
            await runAiAgent(dataset, prompt, model, result);
            return;
        }
        // 环境支持时走 SSE 流式逐字输出，否则回退一次性请求。
        const useStream = typeof createBrowserSseParser === 'function' && typeof apiFetch === 'function';
        state.aiBusy = true;
        if (result) result.innerHTML = '<div class="data-analysis-ai-thinking">AI 正在分析...</div>';
        await guardButton('data-analysis-ai-run', '分析中…', async () => {
            try {
                if (!useStream) {
                    const data = await fetchJson(`${API}/ai`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ datasetId: dataset.id, prompt, model })
                    });
                    if (result) result.innerHTML = renderMarkdown(data.content || 'AI 未返回有效内容');
                    return;
                }
                const res = await apiFetch(`${API}/ai`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                    body: JSON.stringify({ datasetId: dataset.id, prompt, model, stream: true })
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
                        let data = null;
                        try { data = JSON.parse(p); } catch (_e) { return; }
                        const chunk = data?.content ?? data?.choices?.[0]?.delta?.content ?? '';
                        if (chunk) {
                            full += chunk;
                            if (result) result.innerHTML = renderMarkdown(full);
                        }
                    }
                });
                while (!parser.isDone()) {
                    const { done, value } = await reader.read();
                    if (done) {
                        parser.write(decoder.decode());
                        parser.end();
                        break;
                    }
                    parser.write(decoder.decode(value, { stream: true }));
                }
                if (result) result.innerHTML = renderMarkdown(full.trim() || 'AI 未返回有效内容');
            } catch (e) {
                if (result) result.innerHTML = `<div class="data-analysis-empty">AI 分析失败：${esc(e && e.message ? e.message : '请稍后重试')}</div>`;
                toast(e && e.message ? e.message : 'AI 分析失败', 'error');
            } finally {
                state.aiBusy = false;
            }
        });
    }

    Object.assign(app, {
        runAiAgent,
        renderAgentResult,
        replayAgentResult,
        runAi
    });
})();
