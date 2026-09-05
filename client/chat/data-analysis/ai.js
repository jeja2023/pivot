
(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
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
    const ACTIVE_SEMANTIC_STATUSES = new Set(['queued', 'running']);

    function clearSemanticPoll() {
        if (state.semanticPollTimer) {
            clearInterval(state.semanticPollTimer);
            state.semanticPollTimer = null;
        }
    }

    function isActiveSemanticJob(job) {
        return Boolean(job && ACTIVE_SEMANTIC_STATUSES.has(job.status));
    }

    function semanticJobFieldName(job = {}) {
        return String(job?.options?.textFieldName || job?.textField || '未命名字段').trim() || '未命名字段';
    }

    function semanticJobCreatedLabel(job = {}) {
        const value = String(job?.createdAt || job?.startedAt || job?.updatedAt || '').trim();
        return value ? value.replace('T', ' ').slice(0, 16) : '时间未知';
    }

    function semanticJobOptionLabel(job = {}) {
        const status = semanticStatusLabels[job.status] || job.status || '未知状态';
        return `${status} · ${semanticJobFieldName(job)} · ${semanticJobCreatedLabel(job)}`;
    }

    function findSemanticJob(jobId) {
        const normalizedId = String(jobId || '').trim();
        if (!normalizedId) return null;
        return state.semanticJobs.find(item => String(item?.id || '') === normalizedId) || null;
    }

    function upsertSemanticJob(job) {
        if (!job?.id) return;
        const index = state.semanticJobs.findIndex(item => String(item?.id || '') === String(job.id));
        if (index >= 0) state.semanticJobs[index] = { ...state.semanticJobs[index], ...job };
        else state.semanticJobs = [job, ...state.semanticJobs];
    }

    function renderSemanticJobSelector(dataset) {
        const selector = document.getElementById('data-analysis-semantic-job');
        if (!selector) return;
        if (!dataset) {
            setSelectOptions('data-analysis-semantic-job', '<option value="">请先选择数据集</option>', '');
            return;
        }
        const jobs = Array.isArray(state.semanticJobs) ? state.semanticJobs : [];
        const selectedId = state.semanticSelectedJobId || state.semanticJob?.id || '';
        const options = [
            '<option value="">新建任务（不查看历史）</option>',
            ...jobs.map(job => `<option value="${esc(job.id)}">${esc(semanticJobOptionLabel(job))}</option>`)
        ].join('');
        setSelectOptions('data-analysis-semantic-job', options, selectedId);
        const currentJob = jobs.find(j => String(j.id) === String(selectedId));
        selector.title = currentJob ? semanticJobOptionLabel(currentJob) : (selectedId ? '' : '新建任务（不查看历史）');
    }

    function restoreSemanticJobInputs(job) {
        if (!job) return;
        const textField = document.getElementById('data-analysis-semantic-field');
        const idField = document.getElementById('data-analysis-semantic-id-field');
        const instruction = document.getElementById('data-analysis-semantic-instruction');
        const batchTokens = document.getElementById('data-analysis-semantic-batch-tokens');
        if (textField && Array.from(textField.options).some(option => option.value === String(job.textField || ''))) {
            textField.value = String(job.textField || '');
        }
        if (idField) {
            const value = String(job.idField || '');
            idField.value = Array.from(idField.options).some(option => option.value === value) ? value : '';
        }
        if (instruction) instruction.value = String(job.instruction || '');
        const budget = Number(job?.options?.batchTokens);
        if (batchTokens && Number.isFinite(budget) && budget > 0) batchTokens.value = String(budget);
    }

    async function ensureSemanticDatasetDetail(datasetId) {
        const normalizedId = String(datasetId || '').trim();
        if (!normalizedId) return null;
        let dataset = state.datasets.find(item => String(item?.id || '') === normalizedId) || null;
        if (dataset && Array.isArray(dataset.columns) && dataset.columns.length) return dataset;
        const data = await fetchJson(`${API}/datasets/${encodeURIComponent(normalizedId)}`);
        if (!data?.dataset) throw new Error('未找到全量语义分析数据集。');
        const index = state.datasets.findIndex(item => String(item?.id || '') === normalizedId);
        if (index >= 0) state.datasets[index] = data.dataset;
        else state.datasets.push(data.dataset);
        return data.dataset;
    }

    function syncSemanticDatasetSelector(datasetId) {
        const selector = document.getElementById('data-analysis-semantic-dataset');
        if (!selector) return;
        if (Array.from(selector.options).some(option => option.value === String(datasetId || ''))) {
            selector.value = String(datasetId || '');
        }
    }

    function setAiRunning(running) {
        state.aiBusy = Boolean(running);
        const stopBtn = document.getElementById('data-analysis-ai-stop');
        const runBtn = document.getElementById('data-analysis-ai-run');
        const promptInput = document.getElementById('data-analysis-ai-prompt');
        const deepToggle = document.getElementById('data-analysis-ai-deep');
        const modelSelector = document.getElementById('data-analysis-ai-model');
        if (stopBtn) stopBtn.classList.toggle('hidden', !running);
        if (runBtn) {
            runBtn.disabled = Boolean(running);
            runBtn.textContent = running ? '分析中…' : '生成建议';
        }
        if (promptInput) promptInput.disabled = Boolean(running);
        if (deepToggle) deepToggle.disabled = Boolean(running);
        if (modelSelector) modelSelector.disabled = Boolean(running) || !modelSelector.value;
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

    // 渲染数据集特征画像概览与顶部微型徽章
    function renderAiDatasetProfile() {
        const dataset = activeDataset();
        const profileEl = document.getElementById('data-analysis-ai-profile-content');
        if (!dataset) {
            if (profileEl) {
                PivotSafeHtml.setHtml(profileEl, '<div class="data-analysis-ai-profile-empty">请选择分析数据集以查看字段画像与推荐探索方向。</div>');
            }
            return;
        }

        if (profileEl) {
            const columns = Array.isArray(dataset.columns) ? dataset.columns : [];
            const summary = state.summary;
            const numericKeys = new Set((summary?.numericColumns || []).map(c => c.key || c.name));
            const numCols = columns.filter(c => {
                const typeStr = String(c.type || '').toLowerCase();
                return numericKeys.has(c.key || c.name) || ['integer', 'double', 'float', 'number', 'int', 'decimal', 'numeric'].some(t => typeStr.includes(t));
            });
            const dateCols = columns.filter(c => {
                const typeStr = String(c.type || '').toLowerCase();
                return ['date', 'time', 'timestamp'].some(t => typeStr.includes(t));
            });
            const textCols = columns.filter(c => !numCols.includes(c) && !dateCols.includes(c));

            const totalRows = fmtNumber(dataset.rowCount || dataset.sourceRowCount || 0);
            const totalCols = columns.length;

            const nameEl = document.getElementById('data-analysis-ai-profile-name');
            if (nameEl) nameEl.textContent = dataset.name ? `当前：${dataset.name}` : '';

            const kpisHtml = `
                <div class="data-analysis-ai-profile-kpis">
                    <div class="data-analysis-ai-kpi-card">
                        <span class="data-analysis-ai-kpi-lbl">数据规模</span>
                        <div class="data-analysis-ai-kpi-val">${totalRows} <span class="kpi-unit">行</span></div>
                    </div>
                    <div class="data-analysis-ai-kpi-card">
                        <span class="data-analysis-ai-kpi-lbl">字段总数</span>
                        <div class="data-analysis-ai-kpi-val">${totalCols} <span class="kpi-unit">列</span></div>
                    </div>
                    <div class="data-analysis-ai-kpi-card">
                        <span class="data-analysis-ai-kpi-lbl">数值指标</span>
                        <div class="data-analysis-ai-kpi-val">${numCols.length} <span class="kpi-unit">项</span></div>
                    </div>
                    <div class="data-analysis-ai-kpi-card">
                        <span class="data-analysis-ai-kpi-lbl">文本与维度</span>
                        <div class="data-analysis-ai-kpi-val">${textCols.length + dateCols.length} <span class="kpi-unit">项</span></div>
                    </div>
                </div>
            `;

            const colsPreview = columns.map(col => {
                const isNum = numCols.includes(col);
                const isDate = dateCols.includes(col);
                const typeLabel = isNum ? '数值' : (isDate ? '时间' : '文本');
                const badgeClass = isNum ? 'field-badge-num' : (isDate ? 'field-badge-date' : 'field-badge-text');
                const iconSvg = isNum
                    ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line><line x1="10" y1="3" x2="8" y2="21"></line><line x1="16" y1="3" x2="14" y2="21"></line></svg>'
                    : (isDate
                        ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>'
                        : '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>');

                return `
                    <div class="data-analysis-ai-field-chip" title="${esc(col.name)} (${esc(col.type || '未指定')})">
                        <span class="field-icon">${iconSvg}</span>
                        <span class="field-name">${esc(col.name)}</span>
                        <span class="field-type-pill ${badgeClass}">${typeLabel}</span>
                    </div>
                `;
            }).join('');

            PivotSafeHtml.setHtml(profileEl, `
                ${kpisHtml}
                <div class="data-analysis-ai-profile-fields-section">
                    <div class="data-analysis-ai-profile-section-header">
                        <span>字段构成与类型分布</span>
                        <span class="section-count">${columns.length} 个可用字段</span>
                    </div>
                    <div class="data-analysis-ai-profile-fields-wrap">
                        ${colsPreview || '<span class="empty-hint">暂无字段信息</span>'}
                    </div>
                </div>
            `);
        }
    }

    // 即时 AI 探索结果只属于当前页面会话；全量语义任务是持久化任务，
    // 切换页面时保留已选任务及其报告，避免历史回放再次被清空。
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
        document.getElementById('data-analysis-ai-result-wrap')?.classList.add('hidden');
        document.getElementById('data-analysis-ai-landing')?.classList.remove('hidden');
        const prompt = document.getElementById('data-analysis-ai-prompt');
        if (prompt) prompt.value = '';
        document.getElementById('data-analysis-ai-clear-prompt')?.classList.add('hidden');
        const deep = document.getElementById('data-analysis-ai-deep');
        if (deep) deep.checked = false;
        renderAiDatasetProfile();
        renderSemanticControls();
    }

    function resumeAiWorkspace() {
        renderSemanticControls();
        if (isActiveSemanticJob(state.semanticJob)) startSemanticPoll(state.semanticJob.id);
    }

    function semanticDataset() {
        const datasetId = state.semanticDatasetId || state.activeId || document.getElementById('data-analysis-semantic-dataset')?.value;
        if (!datasetId) return null;
        return state.datasets?.find(item => String(item?.id || '') === String(datasetId)) || null;
    }

    function renderSemanticControls() {
        if (!document.getElementById('data-analysis-semantic-field')) return;
        const dataset = semanticDataset();
        const columns = dataset?.columns || [];

        const status = document.getElementById('data-analysis-semantic-status');
        const progress = document.getElementById('data-analysis-semantic-progress');
        const report = document.getElementById('data-analysis-semantic-report');
        const copyBtn = document.getElementById('data-analysis-semantic-copy-report');
        const run = document.getElementById('data-analysis-semantic-run');
        const cancel = document.getElementById('data-analysis-semantic-cancel');
        const retry = document.getElementById('data-analysis-semantic-retry');

        if (!dataset) {
            renderSemanticJobSelector(null);
            setSelectOptions('data-analysis-semantic-field', '<option value="">请先选择全量分析数据集</option>', '');
            setSelectOptions('data-analysis-semantic-id-field', '<option value="">请先选择全量分析数据集</option>', '');
            if (status) {
                status.textContent = '未选择分析数据集';
                delete status.dataset.status;
            }
            if (progress) PivotSafeHtml.setHtml(progress, '');
            if (report) {
                PivotSafeHtml.setHtml(report, `
                    <div class="data-analysis-semantic-empty-state">
                        <svg class="data-analysis-semantic-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                        <div class="data-analysis-semantic-empty-title">未选择分析数据集</div>
                        <div class="data-analysis-semantic-empty-desc">请先在顶部下拉框中选择要分析的数据集。</div>
                    </div>
                `);
            }
            if (copyBtn) copyBtn.disabled = true;
            cancel?.classList.add('hidden');
            retry?.classList.add('hidden');
            if (run) run.disabled = true;
            return;
        }

        const profile = Array.isArray(dataset?.profile) ? dataset.profile : [];
        const textColumns = columns.filter(column => profile.find(item => item.key === column.key && item.type === 'text'));
        const textOptions = buildOptions(textColumns.length ? textColumns : columns, { includeEmpty: true, emptyLabel: '请选择文本字段' });
        setSelectOptions('data-analysis-semantic-field', textOptions, document.getElementById('data-analysis-semantic-field')?.value || textColumns[0]?.key || columns[0]?.key || '');
        setSelectOptions('data-analysis-semantic-id-field', buildOptions(columns, { includeEmpty: true, emptyLabel: '按行号标识' }));
        renderSemanticJobSelector(dataset);

        const job = state.semanticJob;
        if (!job) {
            if (status) {
                status.textContent = state.semanticJobs.length ? '请选择历史任务或新建任务' : '未创建任务';
                delete status.dataset.status;
            }
            if (progress) PivotSafeHtml.setHtml(progress, '');
            if (report) {
                PivotSafeHtml.setHtml(report, `
                    <div class="data-analysis-semantic-empty-state">
                        <svg class="data-analysis-semantic-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                        <div class="data-analysis-semantic-empty-title">暂无分析报告</div>
                        <div class="data-analysis-semantic-empty-desc">在左侧配置分析字段并启动全量任务，或在任务记录中选择历史任务查看分析报告。</div>
                    </div>
                `);
            }
            if (copyBtn) copyBtn.disabled = true;
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
            const error = String(job.lastError || '').trim();
            const empty = error
                ? `<p class="data-analysis-semantic-error-hint">${esc(error)}</p>`
                : `
                    <div class="data-analysis-semantic-empty-state">
                        <svg class="data-analysis-semantic-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                        <div class="data-analysis-semantic-empty-title">${isActiveSemanticJob(job) ? '全量分析执行中…' : '任务无汇总报告内容'}</div>
                        <div class="data-analysis-semantic-empty-desc">${isActiveSemanticJob(job) ? '正在逐批进行大模型语义处理，处理完毕后将在此处实时呈现分析报告。' : '当前任务未生成有效分析文本。'}</div>
                    </div>
                `;
            PivotSafeHtml.setHtml(report, text ? renderMarkdown(text) : empty);
            if (copyBtn) copyBtn.disabled = !text;
        }
        const active = isActiveSemanticJob(job);
        run && (run.disabled = active);
        cancel?.classList.toggle('hidden', !active);
        retry?.classList.toggle('hidden', job.status !== 'failed' && job.status !== 'cancelled');
    }

    async function selectSemanticJob(jobId, options = {}) {
        const normalizedId = String(jobId || '').trim();
        const expectedDatasetId = String(options.datasetId || state.semanticDatasetId || '').trim();
        if (!normalizedId) {
            clearSemanticPoll();
            state.semanticSelectedJobId = '';
            state.semanticJob = null;
            renderSemanticControls();
            return null;
        }

        let job = options.job || findSemanticJob(normalizedId);
        let detailError = null;
        try {
            const data = await fetchJson(`${API}/semantic-analysis/jobs/${encodeURIComponent(normalizedId)}`);
            if (data?.job) job = data.job;
        } catch (error) {
            detailError = error;
        }

        if (options.loadVersion !== undefined && options.loadVersion !== state.semanticLoadVersion) return null;
        if (expectedDatasetId && String(state.semanticDatasetId || '') !== expectedDatasetId) return null;
        if (!job) throw detailError || new Error('未找到全量语义分析任务记录。');
        if (expectedDatasetId && job.datasetId && String(job.datasetId) !== expectedDatasetId) {
            throw new Error('该任务不属于当前选择的数据集。');
        }

        clearSemanticPoll();
        state.semanticSelectedJobId = String(job.id);
        state.semanticJob = job;
        upsertSemanticJob(job);
        renderSemanticControls();
        restoreSemanticJobInputs(job);
        if (isActiveSemanticJob(job)) startSemanticPoll(job.id);
        return job;
    }

    async function loadSemanticJobs(datasetId = state.semanticDatasetId, options = {}) {
        const normalizedDatasetId = String(datasetId || state.semanticDatasetId || state.activeId || '').trim();
        state.semanticDatasetId = normalizedDatasetId;
        const loadVersion = Number(state.semanticLoadVersion || 0) + 1;
        state.semanticLoadVersion = loadVersion;
        clearSemanticPoll();
        state.semanticJobs = [];
        state.semanticJob = null;
        state.semanticSelectedJobId = '';
        if (!normalizedDatasetId) {
            renderSemanticControls();
            return null;
        }
        try {
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(normalizedDatasetId)}/semantic-analysis/jobs?limit=100`);
            if (loadVersion !== state.semanticLoadVersion || String(state.semanticDatasetId || '') !== normalizedDatasetId) return null;
            state.semanticJobs = Array.isArray(data.jobs) ? data.jobs : [];
            const preferredId = String(options.preferredJobId || '').trim();
            let selected = findSemanticJob(preferredId)
                || state.semanticJobs.find(isActiveSemanticJob)
                || state.semanticJobs[0]
                || null;
            if (!selected && options.fallbackJob?.id) {
                selected = options.fallbackJob;
                upsertSemanticJob(selected);
            }
            if (!selected) {
                renderSemanticControls();
                return null;
            }
            return await selectSemanticJob(selected.id, {
                job: selected,
                datasetId: normalizedDatasetId,
                loadVersion
            });
        } catch (e) {
            if (loadVersion !== state.semanticLoadVersion) return null;
            console.warn('[data-analysis] 加载全量语义分析任务失败', e);
            if (options.fallbackJob?.id) {
                state.semanticJobs = [options.fallbackJob];
                return await selectSemanticJob(options.fallbackJob.id, {
                    job: options.fallbackJob,
                    datasetId: normalizedDatasetId,
                    loadVersion
                });
            }
            renderSemanticControls();
            throw e;
        }
    }

    async function refreshSemanticJob(jobId) {
        const data = await fetchJson(`${API}/semantic-analysis/jobs/${encodeURIComponent(jobId)}`);
        if (state.semanticJob?.id !== jobId) return;
        state.semanticJob = data.job || state.semanticJob;
        state.semanticSelectedJobId = state.semanticJob?.id || state.semanticSelectedJobId;
        const index = state.semanticJobs.findIndex(item => item.id === jobId);
        if (index >= 0) state.semanticJobs[index] = { ...state.semanticJobs[index], ...state.semanticJob, batches: undefined };
        renderSemanticControls();
        if (!isActiveSemanticJob(state.semanticJob)) clearSemanticPoll();
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
        const dataset = semanticDataset();
        if (!dataset) return toast('请先选择全量分析数据集', 'warning');
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
                    model: window.Pivot.legacy.PivotAppModels?.getSelectedModel?.('data-analysis', 'data-analysis-ai-model')
                        || document.getElementById('data-analysis-ai-model')?.value
                        || ''
                })
            });
            state.semanticJob = data.job;
            state.semanticSelectedJobId = data.job?.id || '';
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
            state.semanticSelectedJobId = data.job?.id || state.semanticSelectedJobId;
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
            state.semanticSelectedJobId = data.job?.id || state.semanticSelectedJobId;
            renderSemanticControls();
            startSemanticPoll(job.id);
            toast('失败批次已重新排队');
        });
    }

    async function openSemanticHistoryRecord(item, datasetId = state.activeId) {
        const semantic = item?.semantic || {};
        const jobId = String(semantic.jobId || item?.metadata?.jobId || '').trim();
        const normalizedDatasetId = String(datasetId || '').trim();
        if (!jobId) throw new Error('该历史记录缺少任务标识，无法恢复。');
        if (!normalizedDatasetId) throw new Error('该历史记录缺少所属数据集，无法恢复。');

        state.semanticDatasetId = normalizedDatasetId;
        await ensureSemanticDatasetDetail(normalizedDatasetId);
        syncSemanticDatasetSelector(normalizedDatasetId);
        const fallbackJob = {
            id: jobId,
            datasetId: normalizedDatasetId,
            status: 'succeeded',
            textField: semantic.textField || semantic.options?.textFieldName || '',
            idField: semantic.idField || '',
            totalRows: semantic.coverage?.totalRows || 0,
            analyzedRows: semantic.coverage?.analyzedRows || 0,
            totalChars: semantic.coverage?.totalChars || 0,
            totalBatches: semantic.coverage?.totalBatches || 0,
            completedBatches: semantic.coverage?.completedBatches || 0,
            progress: 100,
            report: semantic.report || '',
            instruction: semantic.instruction || '',
            result: semantic
        };
        return await loadSemanticJobs(normalizedDatasetId, { preferredJobId: jobId, fallbackJob });
    }

    async function openAiAnalysisHistoryRecord(item, datasetId = state.activeId) {
        if (!item) throw new Error('未找到分析历史记录。');
        const targetDatasetId = String(item.datasetId || datasetId || state.activeId || '').trim();
        if (!targetDatasetId) throw new Error('该历史记录缺少所属数据集，无法恢复。');

        if (targetDatasetId !== String(state.activeId || '')) {
            await ensureSemanticDatasetDetail(targetDatasetId);
            state.activeId = targetDatasetId;
            const selector = document.getElementById('data-analysis-ai-dataset');
            if (selector && Array.from(selector.options).some(opt => opt.value === targetDatasetId)) {
                selector.value = targetDatasetId;
            }
            renderAiDatasetProfile();
        }

        document.querySelectorAll('.data-analysis-subtab').forEach(btn => {
            const isActive = btn.dataset.aiSubtab === 'chat';
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        document.getElementById('data-analysis-ai-subpanel-chat')?.classList.remove('hidden');
        document.getElementById('data-analysis-ai-subpanel-semantic')?.classList.add('hidden');

        document.getElementById('data-analysis-ai-landing')?.classList.add('hidden');
        const resultWrap = document.getElementById('data-analysis-ai-result-wrap');
        resultWrap?.classList.remove('hidden');

        let analysis = item.analysis;
        if (typeof analysis === 'string') {
            try {
                analysis = JSON.parse(analysis);
            } catch (_e) {
                analysis = { answer: analysis };
            }
        }
        analysis = analysis && typeof analysis === 'object' ? analysis : {};
        const promptText = String(analysis.prompt || item.title || '').trim();
        const answerText = String(analysis.answer || analysis.content || '');
        const isAgent = item.metadata?.mode === 'agent' || Boolean(analysis.steps?.length) || Boolean(analysis.evidence?.length);

        const promptInput = document.getElementById('data-analysis-ai-prompt');
        if (promptInput) {
            promptInput.value = promptText;
            promptInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const clearBtn = document.getElementById('data-analysis-ai-clear-prompt');
        clearBtn?.classList.toggle('hidden', !promptText);

        const deepToggle = document.getElementById('data-analysis-ai-deep');
        if (deepToggle) {
            deepToggle.checked = isAgent;
        }

        const timeEl = document.getElementById('data-analysis-ai-result-time');
        if (timeEl) {
            const timeStr = item.createdAt ? String(item.createdAt).replace('T', ' ').slice(0, 19) : '';
            const modeName = isAgent ? '深度分析' : '即时探索';
            timeEl.textContent = `${modeName}历史记录${timeStr ? ` · ${timeStr}` : ''}`;
        }

        const resultBox = document.getElementById('data-analysis-ai-result');
        if (resultBox) {
            renderAgentResult(resultBox, {
                ...analysis,
                prompt: promptText,
                answer: answerText || 'AI 未返回有效内容',
                isAgent
            });
        }

        resultWrap?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
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
        document.getElementById('data-analysis-ai-landing')?.classList.add('hidden');
        document.getElementById('data-analysis-ai-result-wrap')?.classList.remove('hidden');
        const timeEl = document.getElementById('data-analysis-ai-result-time');
        if (timeEl) {
            const now = new Date();
            const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            timeEl.textContent = `深度分析生成于 ${timeStr}`;
        }
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
        const scopeNotice = (data.scope === 'profile' || data.analysisScope === 'profile')
            ? '<div class="data-analysis-ai-scope-notice">本回答基于数据集字段画像与统计摘要，未执行逐行查询，不应视为精确全量结论。</div>'
            : '';
        const isAgent = Boolean(data.isAgent || (data.steps && data.steps.length > 0) || (data.evidence && data.evidence.length > 0));
        const evidenceHtml = evidence.length ? `
            <details class="data-analysis-ai-evidence">
                <summary>数据依据（${evidence.length} 次查询）</summary>
                ${evidence.map(item => `<div class="data-analysis-ai-evidence-item"><code>${esc(item.sql || '')}</code><span>返回 ${esc(item.rowCount)} 行${item.truncated ? '，结果已截断' : ''}</span></div>`).join('')}
            </details>
        ` : (isAgent ? '<div class="data-analysis-ai-no-evidence">本次回答未获得可验证的 SQL 查询依据。</div>' : '');
        const chartsHtml = charts.length ? `<div class="data-analysis-ai-charts">${charts.map(chart => `
            <div class="pivot-echart-block" data-pivot-echart="${html.escapeAttr(JSON.stringify(chart))}">
                <div class="pivot-echart-title">${esc(chart.title || '图表')}</div>
                <div class="pivot-echart-canvas"></div>
                <canvas height="300"></canvas>
                <pre class="pivot-echart-error-text"></pre>
            </div>
        `).join('')}</div>` : '';
        const promptHtml = data.prompt ? `
            <div class="data-analysis-ai-question-card">
                <div class="data-analysis-ai-question-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                </div>
                <div class="data-analysis-ai-question-content">
                    <span class="data-analysis-ai-question-label">分析诉求</span>
                    <p class="data-analysis-ai-question-text">${esc(data.prompt)}</p>
                </div>
            </div>
        ` : '';
        PivotSafeHtml.setHtml(box, `
            ${promptHtml}
            ${scopeNotice}
            <div class="data-analysis-ai-answer">${renderMarkdown(data.answer || data.content || 'AI 未返回有效内容')}</div>
            ${chartsHtml}
            ${evidenceHtml}
            ${stepsHtml}
        `);
        if (charts.length) window.Pivot.legacy.renderPivotCharts?.(box);
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
        const model = window.Pivot.legacy.PivotAppModels?.getSelectedModel?.('data-analysis', 'data-analysis-ai-model')
            || document.getElementById('data-analysis-ai-model')?.value
            || '';
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
        document.getElementById('data-analysis-ai-landing')?.classList.add('hidden');
        document.getElementById('data-analysis-ai-result-wrap')?.classList.remove('hidden');
        const timeEl = document.getElementById('data-analysis-ai-result-time');
        if (timeEl) {
            const now = new Date();
            const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            timeEl.textContent = `分析建议生成于 ${timeStr}`;
        }
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
        renderAiDatasetProfile,
        renderSemanticControls,
        loadSemanticJobs,
        selectSemanticJob,
        openSemanticHistoryRecord,
        openAiAnalysisHistoryRecord,
        runSemanticAnalysis,
        cancelSemanticAnalysis,
        retrySemanticAnalysis
    });
})();
