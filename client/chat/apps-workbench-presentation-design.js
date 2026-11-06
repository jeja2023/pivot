(function () {
    if (window.Pivot?.moduleApi?.('apps.presentations.design')?.ready) return;
    function reviewMessage(state) {
        const review = state.active?.validation?.visualReview;
        if (!review || review.status === 'not_requested') return '尚未进行视觉模型复核。';
        if (review.localRevision !== state.editRevision || review.localVersion !== state.active.version) return '文稿已变化，之前的视觉复核结果仅供参考，请重新复核。';
        return review.message;
    }
    function generationMessage(proposal = {}) {
        const pages = proposal.generatedPages || proposal.presentation?.slides?.length || 0;
        const split = proposal.plannedPages && pages > proposal.plannedPages ? `（大纲 ${proposal.plannedPages} 页，已完整保留内容拆页）` : '';
        const warnings = Array.isArray(proposal.warnings) ? proposal.warnings.filter(Boolean).length : 0;
        return `AI 初稿已生成，共 ${pages} 页${split}。${warnings ? `另有 ${warnings} 项提示，请在画布中核对。` : '可继续在画布中编辑。'}`;
    }
    function renderDesignIssues(state) {
        const list = document.getElementById('presentation-issues-list'); if (!list) return;
        list.replaceChildren(); const issues = state.active?.validation?.issues || [];
        const note = document.createElement('div'); note.className = 'presentation-empty-note'; note.textContent = reviewMessage(state); list.appendChild(note);
        if (!issues.length) { const empty = document.createElement('div'); empty.className = 'presentation-empty-note'; empty.textContent = '暂无问题。导出前仍可再次执行质量检查。'; list.appendChild(empty); return; }
        for (const issue of issues) {
            const item = document.createElement('button'); item.type = 'button'; item.className = `presentation-issue is-${issue.level || 'info'}`;
            item.dataset.presentationIssueSlide = issue.slideId || ''; item.dataset.presentationIssueElement = issue.elementId || '';
            const title = document.createElement('strong'); title.textContent = issue.message;
            const tip = document.createElement('span'); tip.textContent = issue.suggestion || '';
            item.append(title, tip); list.appendChild(item);
        }
    }
    async function runVisualReview(state, helpers) {
        const { requirePresentationAiModel, beginAiRequest, endAiRequest, saveActive, activeContent, requestJson, aiJsonOptions, switchPanel, renderIssues, toast, isAiAbort } = helpers;
        if (!state.active?.id) return;
        const model = requirePresentationAiModel(); if (!model) return;
        const controller = beginAiRequest(), button = document.getElementById('presentation-visual-review-btn');
        button?.setAttribute('disabled', 'disabled');
        try {
            if (state.dirty) await saveActive();
            const activeId = state.active.id, revision = state.editRevision;
            const slideIndex = activeContent().slides.findIndex(slide => slide.id === state.selectedSlideId);
            const data = await requestJson(`/api/apps/presentations/${encodeURIComponent(activeId)}/visual-review`, aiJsonOptions({ model, slideIndex }, controller));
            if (state.active?.id !== activeId || state.editRevision !== revision) { toast('文稿已变化，请重新复核当前内容。', 'warning'); return; }
            const previous = state.active.validation || { issues: [] };
            state.active.validation = { ...previous, visualReview: { ...data.review, localRevision: state.editRevision, localVersion: state.active.version }, issues: [...(previous.issues || []).filter(issue => !(String(issue.code).startsWith('VISUAL_') && issue.slideId === data.review.slideId)), ...(data.review.issues || [])] };
            const toastType = data.review.status === 'passed' ? 'success' : 'warning';
            switchPanel('issues'); renderIssues(); toast(data.review.message, toastType);
        } catch (error) { if (!isAiAbort(error, controller)) throw error; }
        finally { endAiRequest(controller); button?.removeAttribute('disabled'); }
    }
    const running = task => ['working', 'input_required'].includes(task?.status);
    const taskUrl = (id, taskId = '') => `/api/apps/presentations/${encodeURIComponent(id)}/design-tasks${taskId ? '/' + encodeURIComponent(taskId) : ''}`;
    const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

    function showDeckTask(task, state, helpers, id) {
        const panel = document.getElementById('presentation-design-task-status'); if (!panel) return;
        panel.replaceChildren();
        const progress = task.progress || {}, text = document.createElement('p');
        text.textContent = task.stale ? '文稿已变化，此检查仅对应旧版本，请重新检查。' : running(task)
            ? `${progress.phase === 'layout' ? '正在分析排版' : '正在检查整稿'}：${progress.completed || 0} / ${progress.total || 0} 页`
            : task.status === 'cancelled' ? '检查已取消，已完成的检查记录保留。' : task.error?.message || task.result?.message || '检查已结束。';
        panel.appendChild(text);
        if (running(task)) {
            const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'btn-secondary'; stop.textContent = '停止整稿检查';
            stop.addEventListener('click', async () => {
                stop.disabled = true;
                try { const data = await helpers.requestJson(taskUrl(id, task.id) + '/cancel', post()); showDeckTask(data.task, state, helpers, id); }
                catch (error) { helpers.toast(error.message, 'error'); stop.disabled = false; }
            });
            panel.appendChild(stop);
        } else if (task.status === 'completed' && !task.stale && task.result?.proposal) {
            const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'btn-primary'; apply.textContent = '应用排版优化建议';
            apply.addEventListener('click', async () => {
                apply.disabled = true;
                try {
                    if (state.active?.id !== id || state.dirty) throw new Error('文稿已有新修改，请保存后重新检查。');
                    const checked = await helpers.requestJson(taskUrl(id, task.id));
                    const latest = await helpers.requestJson(`/api/apps/presentations/${encodeURIComponent(id)}`);
                    if (checked.task?.stale || state.active?.id !== id || state.dirty || Number(state.active.version) !== Number(latest.presentation.version)
                        || JSON.stringify(state.active.content) !== JSON.stringify(latest.presentation.content)) throw new Error('文稿已变化，请重新检查最新内容后再应用。');
                    state.active.content = checked.task.result.proposal.content;
                    state.active.validation = checked.task.result.validation || { issues: [] };
                    helpers.recordHistory(); helpers.renderEditor();
                    panel.replaceChildren(); const note = document.createElement('p'); note.textContent = '已应用优化建议，可撤销；请检查并导出最新文稿。'; panel.appendChild(note);
                } catch (error) { helpers.toast(error.message, 'error'); apply.disabled = false; }
            });
            panel.appendChild(apply);
        }
        if (task.status === 'completed' && !task.stale && !task.result?.proposal && task.result?.reviews?.length) {
            const view = document.createElement('button'); view.type = 'button'; view.className = 'btn-secondary'; view.textContent = '查看整稿检查结果';
            view.addEventListener('click', () => helpers.switchPanel('issues')); panel.appendChild(view);
        }
    }

    async function followDeckTask(task, state, helpers, id, revision, sequence) {
        const owner = window.Pivot?.legacy?.currentUser?.id;
        while (state.active?.id === id && state.designTaskSequence === sequence && owner === window.Pivot?.legacy?.currentUser?.id) {
            showDeckTask(task, state, helpers, id);
            if (!running(task)) {
                if (!task.stale && !state.dirty && state.editRevision === revision && task.status === 'completed') {
                    const previous = state.active.validation || { issues: [] };
                    const issues = (task.result?.reviews || []).flatMap(review => review.issues || []);
                    const proposal = Boolean(task.result?.proposal);
                    state.active.validation = { ...previous, visualReview: { status: proposal ? 'proposal' : task.result?.visualStatus,
                        message: proposal ? '本次复核针对排版建议，确认应用前不代表当前文稿已通过。' : task.result?.message,
                        localRevision: state.editRevision, localVersion: state.active.version },
                    issues: proposal ? previous.issues : [...(previous.issues || []).filter(issue => !String(issue.code).startsWith('VISUAL_')), ...issues] };
                    helpers.renderIssues();
                }
                return;
            }
            await new Promise(resolve => window.setTimeout(resolve, 1000));
            const data = await helpers.requestJson(taskUrl(id, task.id));
            if (!data.task) return;
            task = data.task;
        }
    }

    async function startDeckTask(state, helpers, mode) {
        if (!state.active?.id) return;
        const model = mode === 'layout' ? '' : helpers.requirePresentationAiModel(); if (mode !== 'layout' && !model) return;
        const buttons = ['presentation-deck-review-btn', 'presentation-deck-layout-btn'].map(id => document.getElementById(id));
        buttons.forEach(button => { if (button) button.disabled = true; });
        try {
            if (state.dirty) await helpers.saveActive();
            if (state.dirty) throw new Error('文稿尚未保存，请先保存后再检查。');
            const id = state.active.id, revision = state.editRevision, sequence = state.designTaskSequence = (state.designTaskSequence || 0) + 1;
            const data = await helpers.requestJson(taskUrl(id), post({ mode, model }));
            await followDeckTask(data.task, state, helpers, id, revision, sequence);
        } catch (error) { helpers.toast(error.message, 'error'); }
        finally { buttons.forEach(button => { if (button) button.disabled = false; }); }
    }

    async function restoreDeckTask(state, helpers) {
        const id = state.active?.id; if (!id) return;
        const revision = state.editRevision, sequence = state.designTaskSequence = (state.designTaskSequence || 0) + 1;
        document.getElementById('presentation-design-task-status')?.replaceChildren();
        try {
            const data = await helpers.requestJson(taskUrl(id, 'latest'));
            if (data.task && state.active?.id === id) await followDeckTask(data.task, state, helpers, id, revision, sequence);
        } catch (_) { /* 检查记录不可用不阻断文稿编辑。 */ }
    }

    window.Pivot?.exposeModule?.('apps.presentations.design', { ready: true, runVisualReview, reviewMessage, generationMessage, renderDesignIssues, startDeckTask, restoreDeckTask });
})();
