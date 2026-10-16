(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.actionsImportReady) return;

    const {
        API,
        state,
        esc,
        canManage,
        toast,
        fetchJson,
        regulationConfirm,
        getRegulationsSelectedModelId
    } = ns;

    const setBusy = (...args) => ns.setBusy?.(...args);
    const syncImportHint = (...args) => ns.syncImportHint?.(...args);
    const loadDocuments = (...args) => ns.loadDocuments?.(...args);
    const collectForm = (...args) => ns.collectForm?.(...args);
    const closeInlineForms = (...args) => ns.closeInlineForms?.(...args);
    const loadDetail = (...args) => ns.loadDetail?.(...args);
    const syncFileInputState = (...args) => ns.syncFileInputState?.(...args);
    const renderAiAnswer = (...args) => ns.renderAiAnswer?.(...args);
    const stripMarkdownFormatting = (...args) => ns.stripMarkdownFormatting?.(...args);
    const renderAiCardAnswer = (...args) => ns.renderAiCardAnswer?.(...args);
            async function uploadDocument(form) {
                        const fileInput = form.querySelector('#regulations-upload-file');
                        const fileCount = Number(fileInput?.files?.length || 0);
                        if (!fileCount) {
                            toast('请选择要导入的文档', 'warning');
                            return;
                        }
                        const formData = new FormData(form);
                        const endpoint = `${API}/documents/import-jobs`;
                        setBusy(true, fileCount > 1 ? `正在提交 ${fileCount} 个导入任务...` : '正在提交导入任务...');
                        try {
                            const data = await fetchJson(endpoint, { method: 'POST', body: formData });
                            const jobs = Array.isArray(data.jobs) ? data.jobs : [];
                            const failed = Array.isArray(data.failed) ? data.failed : [];
                            const skipped = Array.isArray(data.skipped) ? data.skipped : [];
                            state.importJobs = jobs;
                            renderImportJobs(failed, skipped);
                            toast(`已提交 ${jobs.length} 个导入任务${skipped.length ? `，跳过 ${skipped.length} 个完全重复文件` : ''}${failed.length ? `，${failed.length} 个未提交` : ''}`, failed.length ? 'warning' : 'success');
                            form.reset();
                            syncImportHint(form);
                            scheduleImportJobsRefresh();
                        } catch (e) {
                            toast(e.message || '导入失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    function showImportResult(created, failed) {
                        const panel = document.getElementById('regulations-import-result-panel');
                        const body = document.getElementById('regulations-import-result-body');
                        if (!panel || !body) return;
                        const createdHtml = created.length ? `
                            <div class="regulations-import-section">
                                <div class="regulations-section-head compact"><strong>已导入</strong><span>${created.length} 个</span></div>
                                ${created.map(item => {
                                    const dup = item.duplicateOf ? `<span class="regulations-badge warning">疑似重复：${esc(item.duplicateOf.title || '已有同源')}</span>` : '';
                                    return `<div class="regulations-import-item success">${esc(item.sourceName || item.document?.title || '文档')} ${dup}</div>`;
                                }).join('')}
                            </div>
                        ` : '';
                        const failedHtml = failed.length ? `
                            <div class="regulations-import-section">
                                <div class="regulations-section-head compact"><strong>失败</strong><span>${failed.length} 个</span></div>
                                ${failed.map(item => `
                                    <div class="regulations-import-item error">
                                        <strong>${esc(item.fileName || '文件')}</strong>
                                        <span>${esc(item.message || '导入失败')}</span>
                                    </div>
                                `).join('')}
                            </div>
                        ` : '';
                        PivotSafeHtml.setHtml(body, createdHtml + failedHtml);
                        panel.classList.remove('hidden');
                    }

                    function getImportJobStatusLabel(status) {
                        return ({ queued: '排队中', running: '处理中', retry_wait: '等待重试', completed: '已完成', failed: '失败', cancelled: '已取消' })[status] || '未知状态';
                    }

                    function renderImportJobs(submitFailed = [], skipped = []) {
                        const target = document.getElementById('regulations-import-jobs');
                        if (!target) return;
                        const jobs = Array.isArray(state.importJobs) ? state.importJobs : [];
                        if (!jobs.length && !submitFailed.length && !skipped.length) {
                            target.classList.add('hidden');
                            PivotSafeHtml.setHtml(target, '');
                            return;
                        }
                        target.classList.remove('hidden');
                        PivotSafeHtml.setHtml(target, `
                            <div class="regulations-admin-group-head"><strong>导入任务</strong><span>${jobs.length} 项</span></div>
                            <div class="table-container workspace-table-wrap">
                                <table class="data-table compact-table">
                                    <thead><tr><th>文件</th><th>状态</th><th>进度</th><th>结果</th><th>操作</th></tr></thead>
                                    <tbody>
                                        ${jobs.map(job => {
                                            const action = ['failed', 'cancelled'].includes(job.status)
                                                ? `<button type="button" class="btn-secondary regulations-import-job-action" data-regulation-import-retry="${esc(job.id)}">重试</button>`
                                                : ['queued', 'retry_wait'].includes(job.status)
                                                    ? `<button type="button" class="btn-secondary regulations-import-job-action" data-regulation-import-cancel="${esc(job.id)}">取消</button>`
                                                    : '-';
                                            return `<tr><td>${esc(job.sourceName || job.source_name || '法规文档')}</td><td>${esc(getImportJobStatusLabel(job.status))}</td><td>${Number(job.progress || 0)}%</td><td>${esc(job.errorMessage || job.error_message || job.result?.document?.title || (job.status === 'completed' ? '已入库' : ''))}</td><td>${action}</td></tr>`;
                                        }).join('')}
                                        ${skipped.map(item => `<tr><td>${esc(item.fileName || '法规文档')}</td><td>已跳过</td><td>-</td><td>${esc(`文件与“${item.duplicateOf?.title || '已有法规'}”完全相同`)}</td><td>-</td></tr>`).join('')}
                                        ${submitFailed.map(item => `<tr><td>${esc(item.fileName || '法规文档')}</td><td>未提交</td><td>-</td><td>${esc(item.message || '创建任务失败')}</td><td>-</td></tr>`).join('')}
                                    </tbody>
                                </table>
                            </div>
                        `);
                    }

                    function scheduleImportJobsRefresh() {
                        if (state.importJobsTimer) window.clearTimeout(state.importJobsTimer);
                        const hasActive = state.importJobs.some(job => ['queued', 'running', 'retry_wait'].includes(job.status));
                        if (!hasActive) return;
                        state.importJobsTimer = window.setTimeout(() => {
                            loadImportJobs().catch(() => {});
                        }, 1200);
                    }

                    async function loadImportJobs() {
                        const data = await fetchJson(`${API}/import-jobs?limit=30`);
                        state.importJobs = Array.isArray(data.data) ? data.data : [];
                        renderImportJobs();
                        scheduleImportJobsRefresh();
                        const hasActive = state.importJobs.some(job => ['queued', 'running', 'retry_wait'].includes(job.status));
                        if (!hasActive && state.importJobs.some(job => job.status === 'completed')) {
                            await loadDocuments({ keepActive: true, page: state.page });
                        }
                    }

                    async function retryRegulationImportJob(jobId) {
                        if (!jobId) return;
                        setBusy(true, '正在重新提交导入任务…');
                        try {
                            await fetchJson(`${API}/import-jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' });
                            toast('导入任务已重新提交', 'success');
                            await loadImportJobs();
                        } catch (error) {
                            toast(error.message || '重试导入任务失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    async function cancelRegulationImportJob(jobId) {
                        if (!jobId) return;
                        const accepted = await regulationConfirm('取消导入任务', '该文件尚未入库。确认取消此导入任务？');
                        if (!accepted) return;
                        setBusy(true, '正在取消导入任务…');
                        try {
                            await fetchJson(`${API}/import-jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
                            toast('导入任务已取消', 'success');
                            await loadImportJobs();
                        } catch (error) {
                            toast(error.message || '取消导入任务失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    async function saveMetadata(form) {
                        const docId = form.dataset.docId;
                        const payload = collectForm(form);
                        const versionId = form.dataset.versionId;
                        const versionKeys = ['versionLabel', 'sourceUrl', 'publishedAt', 'effectiveFrom', 'effectiveTo', 'effectStatus', 'reviewStatus'];
                        const versionPatch = Object.fromEntries(versionKeys.map(key => [key, payload[key]]).filter(([, value]) => value !== undefined));
                        versionKeys.forEach(key => { delete payload[key]; });
                        setBusy(true, '正在保存法规信息...');
                        try {
                            await fetchJson(`${API}/documents/${encodeURIComponent(docId)}`, {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(payload)
                            });
                            if (versionId) {
                                await fetchJson(`${API}/documents/${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionId)}/governance`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify(versionPatch)
                                });
                            }
                            toast('法规信息已保存');
                            closeInlineForms();
                            await loadDocuments({ keepActive: true, page: state.page });
                            await loadDetail(docId);
                        } catch (e) {
                            toast(e.message || '保存失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    async function uploadVersion(form) {
                        const docId = form.dataset.docId;
                        const fileInput = form.querySelector('input[type="file"]');
                        if (!fileInput?.files?.length) {
                            toast('请选择新版本文件', 'warning');
                            return;
                        }
                        const formData = new FormData(form);
                        setBusy(true, '正在上传新版本...');
                        try {
                            await fetchJson(`${API}/documents/${encodeURIComponent(docId)}/versions`, { method: 'POST', body: formData });
                            toast('新版本已上传');
                            form.reset();
                            syncFileInputState(fileInput);
                            closeInlineForms();
                            await loadDocuments({ keepActive: true, page: state.page });
                            await loadDetail(docId);
                        } catch (e) {
                            toast(e.message || '上传版本失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    async function archiveDocument(id) {
                        if (!id) return;
                        if (!(await regulationConfirm('删除法规文档', '确定删除该法规文档吗？删除后仅管理员可在归档列表中查看。'))) return;
                        setBusy(true, '正在删除法规文档...');
                        try {
                            await fetchJson(`${API}/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
                            state.selectedDocumentIds.delete(String(id));
                            toast('法规文档已删除');
                            state.activeId = '';
                            state.detail = null;
                            document.getElementById('regulations-detail-panel')?.classList.add('hidden');
                            await loadDocuments({ keepActive: false, page: 1 });
                        } catch (e) {
                            toast(e.message || '删除失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    async function askAi() {
                        const questionInput = document.getElementById('regulations-ai-question');
                        const question = questionInput?.value.trim() || '';
                        if (!question || state.aiBusy) {
                            if (!question) toast('请输入要咨询的问题', 'warning');
                            return;
                        }
                        const modelSelector = document.getElementById('regulations-ai-model');
                        const askBtn = document.getElementById('regulations-ai-btn');
                        const stopBtn = document.getElementById('regulations-ai-stop-btn');
                        const history = state.aiTurns.filter(turn => !turn.streaming).slice(-4).map(turn => ({ question: turn.question, answer: turn.answer }));
                        const model = getRegulationsSelectedModelId() || undefined;
                        const scope = document.getElementById('regulations-ai-scope')?.value || state.aiScope;
                        state.aiScope = scope === 'document' && state.detail?.document?.id ? 'document' : 'library';
                        const documentId = state.aiScope === 'document' ? state.detail?.document?.id : undefined;
                        const versionId = state.aiScope === 'document' ? (state.detail?.currentVersion?.id || state.detail?.currentVersion?.version_id) : undefined;
                        const articleIds = [...(state.aiSelectedArticleIds || new Set())].map(Number).filter(Number.isSafeInteger);
                        const filters = state.aiScope === 'library' ? (state.filters || {}) : {};
                        const requestPayload = {
                            query: question,
                            limit: 14,
                            candidateLimit: 120,
                            history,
                            model,
                            documentId,
                            versionId,
                            articleIds,
                            restrictToSelected: Boolean(state.aiRestrictToSelected && articleIds.length),
                            category: filters.category || '',
                            issuingBody: filters.issuingBody || '',
                            jurisdiction: filters.jurisdiction || '',
                            status: filters.status || '',
                            effectiveAt: state.effectiveAt || ''
                        };
                        const turn = { question, answer: '', sources: [], grounding: null, diagnostics: null, documentId: documentId || null, streaming: true };
                        const turnIndex = state.aiTurns.push(turn) - 1;
                        const controller = new AbortController();
                        state.aiAbortController = controller;
                        state.aiBusy = true;
                        if (modelSelector) modelSelector.disabled = true;
                        if (askBtn) askBtn.disabled = true;
                        if (stopBtn) {
                            stopBtn.classList.remove('hidden');
                            stopBtn.disabled = false;
                        }
                        if (questionInput) questionInput.value = '';
                        renderAiAnswer();
                        const useStream = typeof createBrowserSseParser === 'function' && typeof apiFetch === 'function';
                        let full = '';
                        let sources = [];
                        try {
                            if (!useStream) {
                                const data = await fetchJson(`${API}/ai`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify(requestPayload)
                                });
                                full = data.content || data.answer || '';
                                sources = Array.isArray(data.sources) ? data.sources : [];
                                turn.grounding = data.grounding || null;
                                turn.diagnostics = data.diagnostics || null;
                            } else {
                                const res = await apiFetch(`${API}/ai`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                                    body: JSON.stringify({ ...requestPayload, stream: true }),
                                    signal: controller.signal
                                });
                                if (!res.ok || !res.body) {
                                    const data = await res.clone().json().catch(() => ({}));
                                    throw new Error(data?.error?.message || `AI 请求失败（${res.status}）`);
                                }
                                const reader = res.body.getReader();
                                const decoder = new TextDecoder();
                                let streamError = null;
                                const parser = createBrowserSseParser({
                                    onData(payload) {
                                        let data;
                                        try { data = JSON.parse(payload); } catch (_error) { return; }
                                        if (data?.type === 'apps.extra') {
                                            sources = Array.isArray(data.sources) ? data.sources : sources;
                                            turn.diagnostics = data.diagnostics || turn.diagnostics;
                                            return;
                                        }
                                        if (data?.type === 'apps.completion') {
                                            turn.grounding = data.grounding || turn.grounding;
                                            return;
                                        }
                                        if (data?.error?.message) {
                                            streamError = new Error(data.error.message);
                                            return;
                                        }
                                        const chunk = data?.content ?? data?.choices?.[0]?.delta?.content ?? '';
                                        if (!chunk) return;
                                        full += chunk;
                                        turn.answer = full;
                                        const target = document.getElementById(`regulations-ai-answer-${turnIndex}`);
                                        if (target) {
                                            if (typeof renderAiCardAnswer === 'function') {
                                                PivotSafeHtml.setHtml(target, renderAiCardAnswer(full));
                                            } else if (typeof stripMarkdownFormatting === 'function') {
                                                target.textContent = stripMarkdownFormatting(full);
                                            } else {
                                                target.textContent = full;
                                            }
                                        }
                                        document.getElementById('regulations-ai-answer')?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' });
                                    }
                                });
                                while (!parser.isDone() && !controller.signal.aborted) {
                                    const { done, value } = await reader.read();
                                    if (done) {
                                        parser.write(decoder.decode());
                                        parser.end();
                                        break;
                                    }
                                    parser.write(decoder.decode(value, { stream: true }));
                                }
                                if (streamError) throw streamError;
                            }
                            const finalAnswer = typeof stripMarkdownFormatting === 'function' ? stripMarkdownFormatting(full) : full;
                            turn.answer = finalAnswer.trim() || 'AI 未返回有效内容';
                            turn.sources = sources;
                        } catch (error) {
                            if (controller.signal.aborted || error?.name === 'AbortError') {
                                const stoppedAnswer = typeof stripMarkdownFormatting === 'function' ? stripMarkdownFormatting(full) : full;
                                turn.answer = stoppedAnswer.trim() || '已停止生成，尚未返回内容。';
                                if (!state.aiStopSilently) toast('已停止生成回答', 'info');
                            } else {
                                state.aiTurns.splice(turnIndex, 1);
                                toast(error.message || 'AI 回答失败', 'error');
                            }
                        } finally {
                            turn.streaming = false;
                            state.aiBusy = false;
                            state.aiStopSilently = false;
                            if (state.aiAbortController === controller) state.aiAbortController = null;
                            if (modelSelector) modelSelector.disabled = !modelSelector.value;
                            if (askBtn) askBtn.disabled = false;
                            if (stopBtn) {
                                stopBtn.classList.add('hidden');
                                stopBtn.disabled = true;
                            }
                            renderAiAnswer();
                        }
                    }

                    function stopRegulationAi(options = {}) {
                        if (!state.aiBusy || !state.aiAbortController) return;
                        state.aiStopSilently = Boolean(options.silent);
                        state.aiAbortController.abort();
                    }

                    async function loadFacets() {
                        try {
                            const data = await fetchJson(`${API}/facets${canManage() && state.filters.includeArchived ? '?includeArchived=true' : ''}`);
                            state.facets.categories = Array.isArray(data.categories) ? data.categories : [];
                            state.facets.legalLevels = Array.isArray(data.legalLevels) ? data.legalLevels : [];
                            state.facets.issuingBodies = Array.isArray(data.issuingBodies) ? data.issuingBodies : [];
                            state.facets.jurisdictions = Array.isArray(data.jurisdictions) ? data.jurisdictions : [];
                            const catList = document.getElementById('regulations-category-list');
                            const legalLevelList = document.getElementById('regulations-legal-level-list');
                            const issuingBodyList = document.getElementById('regulations-issuing-body-list');
                            const jurList = document.getElementById('regulations-jurisdiction-list');
                            if (catList) PivotSafeHtml.setHtml(catList, state.facets.categories.map(c => `<option value="${esc(c)}">`).join(''));
                            if (legalLevelList) PivotSafeHtml.setHtml(legalLevelList, state.facets.legalLevels.map(item => `<option value="${esc(item)}">`).join(''));
                            if (issuingBodyList) PivotSafeHtml.setHtml(issuingBodyList, state.facets.issuingBodies.map(item => `<option value="${esc(item)}">`).join(''));
                            if (jurList) PivotSafeHtml.setHtml(jurList, state.facets.jurisdictions.map(j => `<option value="${esc(j)}">`).join(''));
                        } catch (_e) {
                            // facets 失败不影响主流程
                        }
                    }

                    function clearAiTurns() {
                        state.aiTurns = [];
                        renderAiAnswer();
                    }

                    // #4 引用网络：拉取条文引用图并用轻量 SVG 渲染（环形布局，无第三方库）

        Object.assign(ns, {
            uploadDocument,
            showImportResult,
            renderImportJobs,
            loadImportJobs,
            retryRegulationImportJob,
            cancelRegulationImportJob,
            scheduleImportJobsRefresh,
            saveMetadata,
            uploadVersion,
            archiveDocument,
            askAi,
            stopRegulationAi,
            loadFacets,
            clearAiTurns,
            actionsImportReady: true
        });
})();
